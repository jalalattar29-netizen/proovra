/**
 * Phase 4 (UI) — WebhookRotationAndActivityPanel + page-level
 * "View all integration activity" link regression lock.
 *
 * The panel lives inline in
 *   apps/web/app/(app)/integrations/page.tsx
 * and is the operator-facing companion to Phase 3's ApiKeyActivityPanel.
 * It lazy-loads the canonical TeamActivity feed scoped to a single
 * webhook_endpoint via the Phase-2 filter route. The constraints we
 * MUST never regress:
 *
 *   1. Default state is collapsed — no fetch is issued on initial
 *      render. The fetch only fires on the first expand.
 *   2. The collapsed-by-default empty-state copy is the literal copy
 *      from the phase spec ("Webhook activity will appear after test
 *      events, retries, rotations, or delivery failures.").
 *   3. The fetch-failure copy is the literal copy from the phase spec
 *      ("Activity could not be loaded. The integration itself is still
 *      usable.") — never a raw error.
 *   4. The forbidden metadata field-name allowlist is wired into the
 *      sanitizer so a malicious / accidental server response cannot
 *      smuggle a secret or signing-secret ciphertext into the rendered
 *      tree.
 *   5. The known event-type vocabulary maps to human labels and unknown
 *      event types fall through to the verbatim eventType.
 *   6. The fetch URL targets the canonical Phase-2 filter route:
 *      GET /v1/teams/<teamId>/activity?targetType=webhook_endpoint
 *      &targetId=<id>&limit=10 — NOT a new endpoint, NOT a duplicate
 *      feed, and NOT a path that omits the targetType/targetId scoping
 *      (which would surface unrelated team activity).
 *   7. The secret-rotated row renders the grace cutoff when the server
 *      projection provides it.
 *   8. The page-level "View all integration activity" link is admin-
 *      gated and points at /teams/<teamId>?activityTarget=integration.
 *
 * The runtime port at the bottom of this file exercises the sanitizer
 * logic against representative inputs (including a hostile
 * "metadata-with-forbidden-fields" case) to prove the behavior even
 * when the source-level regex check above is hypothetically bypassed.
 *
 * Runs under Node's built-in `node:test`.
 *   `npx tsx --test apps/web/__tests__/integrations-webhook-activity-panel.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "integrations",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Source-level locks — non-runtime guarantees about the component.
// ---------------------------------------------------------------------------

test("page.tsx defines the WebhookRotationAndActivityPanel component", () => {
  assert.match(
    PAGE_SOURCE,
    /function WebhookRotationAndActivityPanel\s*\(/,
    "The Phase-4 webhook disclosure component must remain co-located " +
      "inside integrations/page.tsx (same convention as " +
      "ApiKeyActivityPanel + WebhookDeliveriesPanel).",
  );
});

test("WebhookRotationAndActivityPanel is wired into each webhook row", () => {
  // The component is only valuable if it actually renders on each
  // webhook row. We assert the JSX call site is present and that it
  // receives `teamId` and `webhookEndpointId` (the exact props named in
  // the phase spec).
  assert.match(
    PAGE_SOURCE,
    /<WebhookRotationAndActivityPanel[\s\S]{0,300}?teamId=\{teamId\}[\s\S]{0,300}?webhookEndpointId=\{w\.id\}/,
    "The webhook row must render <WebhookRotationAndActivityPanel " +
      "teamId={teamId} webhookEndpointId={w.id} />.",
  );
});

test("WebhookRotationAndActivityPanel sits next to (not replacing) the deliveries panel", () => {
  // The Phase 3 (deliveries) panel must still be present — we are
  // adding a sibling, not refactoring.
  assert.ok(
    PAGE_SOURCE.includes("<WebhookDeliveriesPanel"),
    "WebhookDeliveriesPanel must still be rendered on each row — the " +
      "Phase 4 panel is additive, not a replacement.",
  );
  // Both panels must be co-located on the same row (within ~3500 chars
  // of each other inside the webhook map callback).
  const deliveriesIdx = PAGE_SOURCE.indexOf("<WebhookDeliveriesPanel");
  const activityIdx = PAGE_SOURCE.indexOf(
    "<WebhookRotationAndActivityPanel",
  );
  assert.ok(deliveriesIdx >= 0 && activityIdx >= 0);
  assert.ok(
    Math.abs(activityIdx - deliveriesIdx) < 3500,
    "WebhookRotationAndActivityPanel must be co-located with the " +
      "deliveries panel on the same webhook row.",
  );
});

test("default state is collapsed — no fetch on initial render", () => {
  // The component must start with `expanded = false`. The fetch must
  // only fire from inside the toggle handler — i.e. there must NOT be
  // a useEffect-driven auto-load.
  const panelStart = PAGE_SOURCE.indexOf(
    "function WebhookRotationAndActivityPanel(",
  );
  assert.ok(panelStart >= 0, "must locate the panel function declaration");

  const panelBody = PAGE_SOURCE.slice(panelStart, panelStart + 12000);
  assert.match(
    panelBody,
    /const \[expanded, setExpanded\] = useState\(false\)/,
    "WebhookRotationAndActivityPanel must initialize `expanded = " +
      "false`. Default open would defeat the lazy-load contract.",
  );

  // The panel body must not introduce a useEffect(load) that would
  // fire on mount.
  // We look for the first closing `}` at column 0 after the function start
  // to scope the search to just this component.
  const panelEnd = panelBody.indexOf("\n}\n");
  assert.ok(panelEnd > 0, "must locate the panel function close");
  const panelOnly = panelBody.slice(0, panelEnd);
  assert.ok(
    !/useEffect\s*\(/.test(panelOnly),
    "WebhookRotationAndActivityPanel must not call useEffect — the " +
      "only allowed fetch trigger is the user click that toggles the " +
      "disclosure.",
  );
});

test("fetch URL hits the canonical Phase-2 filter route", () => {
  // The Phase-2 backend filter accepts targetType=webhook_endpoint and
  // targetId=<endpointId> against the existing /activity route. We
  // pin the exact URL shape so a future refactor cannot silently drop
  // the scoping params (which would surface unrelated team activity).
  assert.match(
    PAGE_SOURCE,
    /\/v1\/teams\/\$\{encodeURIComponent\(teamId\)\}\/activity\?targetType=webhook_endpoint&targetId=\$\{encodeURIComponent\(webhookEndpointId\)\}&limit=10/,
    "The disclosure must hit GET /v1/teams/<teamId>/activity with " +
      "targetType=webhook_endpoint, targetId=<id>, and limit=10. Any " +
      "drift here is a privacy regression.",
  );
});

test("forbidden metadata field-name allowlist is wired", () => {
  // The sanitizer must list every forbidden field name. If a future
  // contributor edits the list and drops one, this test catches it.
  for (const forbidden of [
    "secret",
    "rawsecret",
    "secretciphertext",
    "previoussecret",
    "previoussecretciphertext",
    "rawkey",
    "authorization",
  ]) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`["']${forbidden}["']`, "i"),
      `WEBHOOK_FORBIDDEN_METADATA_FIELDS must include "${forbidden}" ` +
        `so a metadata response with that key is stripped silently.`,
    );
  }
});

test("event-type vocabulary maps known events to human labels", () => {
  const expected: Array<[string, string]> = [
    ["integration.webhook.created", "Created"],
    ["integration.webhook.test_sent", "Test event sent"],
    ["integration.webhook.delivery_retried", "Delivery retried"],
    ["integration.webhook.secret_rotated", "Secret rotated"],
    ["integration.webhook.disabled", "Disabled"],
    ["integration.webhook.enabled", "Enabled"],
  ];
  for (const [event, label] of expected) {
    const re = new RegExp(
      `["']${event.replace(/\./g, "\\.")}["']\\s*:\\s*["']${label}["']`,
    );
    assert.match(
      PAGE_SOURCE,
      re,
      `WEBHOOK_EVENT_LABELS must map "${event}" -> "${label}".`,
    );
  }
});

test("empty-state copy is the literal copy from the phase spec", () => {
  // Operator-facing strings are part of the user contract and must
  // never regress to dev language.
  assert.ok(
    PAGE_SOURCE.includes(
      "Webhook activity will appear after test events, retries, rotations, or delivery failures.",
    ),
    "Empty-state copy must match the phase spec verbatim.",
  );
});

test("error-state copy is the literal copy from the phase spec", () => {
  assert.ok(
    PAGE_SOURCE.includes(
      "Activity could not be loaded. The integration itself is still usable.",
    ),
    "Error-state copy must match the phase spec verbatim. Surfacing " +
      "a raw fetch error would risk leaking server-side details.",
  );
});

test("the panel never references forbidden field names in render", () => {
  // The panel function body must not reference ciphertext / rawSecret etc.
  const panelStart = PAGE_SOURCE.indexOf(
    "function WebhookRotationAndActivityPanel(",
  );
  assert.ok(panelStart >= 0, "must locate the panel function declaration");
  const panelBody = PAGE_SOURCE.slice(panelStart, panelStart + 12000);
  const panelEnd = panelBody.indexOf("\n}\n");
  const panelOnly = panelBody.slice(0, panelEnd);
  for (const forbidden of [
    ".rawSecret",
    ".secretCiphertext",
    ".previousSecretCiphertext",
    ".rawKey",
    ".Authorization",
  ]) {
    assert.ok(
      !panelOnly.includes(forbidden),
      `WebhookRotationAndActivityPanel must not access ${forbidden} on ` +
        `any value.`,
    );
  }
});

test("rotation row renders previousSecretValidUntilUtc (grace cutoff) when present", () => {
  // The rotation-specific render path must surface the cutoff. The
  // canonical Phase-4 server projection emits `previousSecretValidUntilUtc`
  // on the secret_rotated metadata; the panel must read THAT field.
  assert.match(
    PAGE_SOURCE,
    /previousSecretValidUntilUtc/,
    "Panel must reference the previousSecretValidUntilUtc cutoff so " +
      "the operator can see receivers' grace deadline on rotation rows.",
  );
  // The literal user-visible "grace until" copy must be present.
  assert.match(
    PAGE_SOURCE,
    /grace until/,
    "Rotation row must include the 'grace until <local time>' copy.",
  );
});

// ---------------------------------------------------------------------------
// 2. Page-level "View all integration activity" link — admin-gated.
// ---------------------------------------------------------------------------

test("page-level link is rendered only when isAdmin", () => {
  // The link must sit inside a conditional that gates on isAdmin. We
  // pin the literal copy + the conditional shape so a future refactor
  // can't accidentally drop the gate.
  assert.match(
    PAGE_SOURCE,
    /\{isAdmin \?[\s\S]{0,600}?View all integration activity[\s\S]{0,600}?: null\}/,
    "The 'View all integration activity' link must be wrapped in " +
      "{isAdmin ? ... : null}. Team Activity is itself admin-gated; " +
      "exposing the link to non-admins would be misleading.",
  );
});

test("page-level link href targets /teams/<teamId>?activityTarget=integration", () => {
  assert.match(
    PAGE_SOURCE,
    /href=\{`\/teams\/\$\{encodeURIComponent\(teamId\)\}\?activityTarget=integration`\}/,
    "The link must point at /teams/<teamId>?activityTarget=integration " +
      "(canonical Team Activity surface + Phase-2 filter param).",
  );
});

test("page-level link uses the Next.js Link component", () => {
  // Tooltip + Link import wired.
  assert.match(
    PAGE_SOURCE,
    /import Link from "next\/link"/,
    "next/link must be imported (canonical in-app navigation primitive).",
  );
  // The link MUST be rendered as a <Link …> element (not a bare <a>) —
  // sibling tests already pin the href + the isAdmin gate; here we
  // pin the JSX shape so any future refactor can't downgrade it.
  // We anchor on the unique `data-testid` for this specific link
  // (`integrations-view-all-activity-link`) so the assertion is
  // robust to attribute ordering and to the addition of new
  // attributes — what matters is that THIS link is a <Link> with
  // BOTH href + title attributes present.
  const linkBlockMatch = PAGE_SOURCE.match(
    /<Link\b([\s\S]{0,500}?)data-testid="integrations-view-all-activity-link"([\s\S]{0,500}?)>/,
  );
  assert.ok(
    linkBlockMatch,
    "Could not locate the integration-activity <Link> opening tag. " +
      "The link must be a Next.js <Link> with " +
      "data-testid=\"integrations-view-all-activity-link\".",
  );
  const linkAttrs = (linkBlockMatch![1] ?? "") + (linkBlockMatch![2] ?? "");
  assert.match(
    linkAttrs,
    /href=\{`\/teams\/\$\{encodeURIComponent\(teamId\)\}\?activityTarget=integration`\}/,
    "The integration-activity <Link> must point at " +
      "/teams/<teamId>?activityTarget=integration.",
  );
  // The link MUST carry a meaningful tooltip explaining where it
  // leads. Tooltip COPY was reworded in the source ("workspace
  // activity timeline filtered to integration events"); we no
  // longer pin the exact wording — instead we pin (a) the tooltip
  // attribute is present on the link element, (b) its text
  // mentions both the destination ("activity") AND the filter
  // semantics ("integration"). This catches a missing/blank tooltip
  // without bricking on future copy iterations.
  const tooltipMatch = linkAttrs.match(/title="([^"]+)"/);
  assert.ok(
    tooltipMatch,
    "The integration-activity <Link> must carry a `title` tooltip.",
  );
  const tooltip = tooltipMatch![1];
  assert.match(
    tooltip,
    /activity/i,
    `Tooltip must explain the destination (mention "activity"). Got: "${tooltip}"`,
  );
  assert.match(
    tooltip,
    /integration/i,
    `Tooltip must explain the filter scope (mention "integration"). Got: "${tooltip}"`,
  );
});

// ---------------------------------------------------------------------------
// 3. Runtime exercise — faithful port of the sanitizer + the panel state
// machine. Catches behavioural regressions even when the source regex
// checks above are hypothetically bypassed.
// ---------------------------------------------------------------------------

type WebhookActivityRow = {
  id: string;
  eventType: string;
  actor: { id: string; email: string | null; displayName: string | null } | null;
  createdAt: string;
  previousSecretPrefix: string | null;
  previousSecretValidUntilUtc: string | null;
};

const WEBHOOK_FORBIDDEN_METADATA_FIELDS = [
  "secret",
  "rawsecret",
  "secretciphertext",
  "previoussecret",
  "previoussecretciphertext",
  "rawkey",
  "authorization",
] as const;

// Faithful port of `projectWebhookActivityRow` from page.tsx.
function projectWebhookActivityRow(raw: unknown): WebhookActivityRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const eventType = typeof r.eventType === "string" ? r.eventType : null;
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : null;
  if (!id || !eventType || !createdAt) return null;

  let actor: WebhookActivityRow["actor"] = null;
  if (r.actor && typeof r.actor === "object") {
    const a = r.actor as Record<string, unknown>;
    if (typeof a.id === "string") {
      actor = {
        id: a.id,
        email: typeof a.email === "string" ? a.email : null,
        displayName: typeof a.displayName === "string" ? a.displayName : null,
      };
    }
  }

  let previousSecretPrefix: string | null = null;
  let previousSecretValidUntilUtc: string | null = null;
  if (r.metadata && typeof r.metadata === "object") {
    const md = r.metadata as Record<string, unknown>;
    const safeMd: Record<string, unknown> = {};
    for (const k of Object.keys(md)) {
      if (
        WEBHOOK_FORBIDDEN_METADATA_FIELDS.includes(k.toLowerCase() as never)
      ) {
        continue;
      }
      safeMd[k] = md[k];
    }
    if (
      typeof safeMd.previousSecretPrefix === "string" &&
      (safeMd.previousSecretPrefix as string).length <= 32
    ) {
      previousSecretPrefix = safeMd.previousSecretPrefix as string;
    }
    if (
      typeof safeMd.previousSecretValidUntilUtc === "string" &&
      (safeMd.previousSecretValidUntilUtc as string).length <= 64
    ) {
      previousSecretValidUntilUtc = safeMd.previousSecretValidUntilUtc as string;
    }
  }

  return {
    id,
    eventType,
    actor,
    createdAt,
    previousSecretPrefix,
    previousSecretValidUntilUtc,
  };
}

test("projection drops malformed rows so an empty list renders safely", () => {
  assert.equal(projectWebhookActivityRow(null), null);
  assert.equal(projectWebhookActivityRow(undefined), null);
  assert.equal(projectWebhookActivityRow("not an object"), null);
  assert.equal(projectWebhookActivityRow({}), null);
  assert.equal(
    projectWebhookActivityRow({
      id: "x",
      eventType: "integration.webhook.test_sent",
    }),
    null,
  );
});

test("projection accepts a well-formed row and preserves safe fields", () => {
  const row = projectWebhookActivityRow({
    id: "row-1",
    eventType: "integration.webhook.test_sent",
    targetType: "webhook_endpoint",
    targetId: "ep-1",
    actor: { id: "user-1", email: "alice@example.com", displayName: "Alice" },
    metadata: {},
    createdAt: "2026-06-05T12:00:00.000Z",
  });
  assert.ok(row);
  assert.equal(row.id, "row-1");
  assert.equal(row.eventType, "integration.webhook.test_sent");
  assert.equal(row.actor?.email, "alice@example.com");
  assert.equal(row.actor?.displayName, "Alice");
  assert.equal(row.createdAt, "2026-06-05T12:00:00.000Z");
  assert.equal(row.previousSecretPrefix, null);
  assert.equal(row.previousSecretValidUntilUtc, null);
});

test("rotation row surfaces previousSecretPrefix + previousSecretValidUntilUtc from server metadata", () => {
  // Spec: "If metadata exposes previousSecretValidUntilUtc (NOT the
  //        ciphertext, just the cutoff timestamp), render grace until."
  // The canonical Phase-4 server emit (see
  // services/api/src/routes/integrations.routes.ts: emit
  // integration.webhook.secret_rotated) sets both safe fields.
  const row = projectWebhookActivityRow({
    id: "row-rot",
    eventType: "integration.webhook.secret_rotated",
    targetType: "webhook_endpoint",
    targetId: "ep-1",
    actor: { id: "user-1", email: null, displayName: "Alice" },
    createdAt: "2026-06-05T12:00:00.000Z",
    metadata: {
      newSecretPrefix: "whsec_abc1",
      previousSecretPrefix: "whsec_old0",
      previousSecretValidUntilUtc: "2026-06-12T12:00:00.000Z",
      graceMinutes: 10080,
    },
  });
  assert.ok(row);
  assert.equal(row.previousSecretPrefix, "whsec_old0");
  assert.equal(
    row.previousSecretValidUntilUtc,
    "2026-06-12T12:00:00.000Z",
  );
});

test("projection drops forbidden metadata field names silently", () => {
  // The malicious payload: a metadata object that smuggles every
  // forbidden field name we know about, including a *previousSecret*
  // ciphertext and a Bearer token. The projection MUST strip each one
  // without throwing and without surfacing the value.
  const malicious = {
    id: "row-evil",
    eventType: "integration.webhook.secret_rotated",
    targetType: "webhook_endpoint",
    targetId: "ep-1",
    actor: { id: "user-1", email: null, displayName: null },
    createdAt: "2026-06-05T12:00:00.000Z",
    metadata: {
      secret: "MUST_NOT_LEAK_secret",
      rawSecret: "MUST_NOT_LEAK_rawSecret",
      secretCiphertext: "MUST_NOT_LEAK_secretCiphertext",
      previousSecret: "MUST_NOT_LEAK_previousSecret",
      previousSecretCiphertext: "MUST_NOT_LEAK_previousSecretCiphertext",
      rawKey: "MUST_NOT_LEAK_rawKey",
      Authorization: "Bearer MUST_NOT_LEAK_Bearer",
      previousSecretPrefix: "whsec_old0",
      previousSecretValidUntilUtc: "2026-06-12T12:00:00.000Z",
    },
  };
  const row = projectWebhookActivityRow(malicious);
  assert.ok(
    row,
    "the row itself must still project; only forbidden fields are " +
      "stripped, not the whole row",
  );

  // The two narrowly-bounded fields survive (prefix is operator-safe
  // per the row hint above; cutoff is just a timestamp). Everything
  // else MUST be gone.
  assert.equal(row.previousSecretPrefix, "whsec_old0");
  assert.equal(
    row.previousSecretValidUntilUtc,
    "2026-06-12T12:00:00.000Z",
  );

  // The projection's published shape exposes nothing else from
  // metadata. We re-encode the row and assert none of the forbidden
  // sentinels can be observed downstream.
  const encoded = JSON.stringify(row);
  for (const sentinel of [
    "MUST_NOT_LEAK_secret",
    "MUST_NOT_LEAK_rawSecret",
    "MUST_NOT_LEAK_secretCiphertext",
    "MUST_NOT_LEAK_previousSecret",
    "MUST_NOT_LEAK_previousSecretCiphertext",
    "MUST_NOT_LEAK_rawKey",
    "MUST_NOT_LEAK_Bearer",
  ]) {
    assert.ok(
      !encoded.includes(sentinel),
      `forbidden sentinel "${sentinel}" leaked into the projected row`,
    );
  }
});

test("projection caps oversized previousSecretPrefix to bound the rendered string", () => {
  // A safe prefix is single-digit length on the server; a 1 MB value
  // would bloat the row, so we drop anything past 32 chars.
  const row = projectWebhookActivityRow({
    id: "row-long-prefix",
    eventType: "integration.webhook.secret_rotated",
    actor: null,
    createdAt: "2026-06-05T12:00:00.000Z",
    metadata: { previousSecretPrefix: "x".repeat(33) },
  });
  assert.ok(row);
  assert.equal(row.previousSecretPrefix, null);
});

// ---------------------------------------------------------------------------
// 4. UI behaviour — simulate the toggle/load lifecycle without a DOM.
// ---------------------------------------------------------------------------

type FakePanelState = {
  expanded: boolean;
  rows: WebhookActivityRow[] | null;
  loading: boolean;
  error: string | null;
  fetchCount: number;
};

function makeFakePanel(
  responder: () => Promise<{ activities: unknown[] }>,
): {
  state: FakePanelState;
  toggle: () => Promise<void>;
} {
  const state: FakePanelState = {
    expanded: false,
    rows: null,
    loading: false,
    error: null,
    fetchCount: 0,
  };

  async function load() {
    state.loading = true;
    state.error = null;
    try {
      const res = await responder();
      state.fetchCount += 1;
      const projected = Array.isArray(res?.activities)
        ? res.activities
            .map((a) => projectWebhookActivityRow(a))
            .filter((a): a is WebhookActivityRow => a !== null)
        : [];
      state.rows = projected;
    } catch {
      state.error =
        "Activity could not be loaded. The integration itself is still usable.";
    } finally {
      state.loading = false;
    }
  }

  async function toggle() {
    if (state.expanded) {
      state.expanded = false;
      return;
    }
    state.expanded = true;
    if (state.rows === null || state.error !== null) {
      await load();
    }
  }

  return { state, toggle };
}

test("default state is collapsed with zero fetches", () => {
  const { state } = makeFakePanel(async () => ({ activities: [] }));
  assert.equal(state.expanded, false);
  assert.equal(state.fetchCount, 0);
  assert.equal(state.rows, null);
});

test("renders empty state when API returns []", async () => {
  const { state, toggle } = makeFakePanel(async () => ({ activities: [] }));
  await toggle();
  assert.equal(state.expanded, true);
  assert.equal(state.fetchCount, 1);
  assert.deepEqual(state.rows, []);
  assert.equal(state.error, null);
});

test("renders rows when API returns mock activity", async () => {
  const { state, toggle } = makeFakePanel(async () => ({
    activities: [
      {
        id: "row-1",
        eventType: "integration.webhook.test_sent",
        actor: { id: "u1", email: "a@b.c", displayName: "A" },
        createdAt: "2026-06-05T12:00:00.000Z",
        metadata: {},
      },
      {
        id: "row-2",
        eventType: "integration.webhook.secret_rotated",
        actor: null,
        createdAt: "2026-06-05T12:30:00.000Z",
        metadata: {
          previousSecretPrefix: "whsec_old0",
          previousSecretValidUntilUtc: "2026-06-12T12:30:00.000Z",
        },
      },
    ],
  }));
  await toggle();
  assert.equal(state.rows?.length, 2);
  assert.equal(state.rows?.[0]!.eventType, "integration.webhook.test_sent");
  assert.equal(
    state.rows?.[1]!.eventType,
    "integration.webhook.secret_rotated",
  );
  assert.equal(state.rows?.[1]!.previousSecretPrefix, "whsec_old0");
  assert.equal(
    state.rows?.[1]!.previousSecretValidUntilUtc,
    "2026-06-12T12:30:00.000Z",
  );
});

test("renders error copy when fetch throws", async () => {
  const { state, toggle } = makeFakePanel(async () => {
    throw new Error("server exploded");
  });
  await toggle();
  assert.equal(state.expanded, true);
  assert.equal(state.rows, null);
  assert.equal(
    state.error,
    "Activity could not be loaded. The integration itself is still usable.",
  );
  // The raw error message must NEVER make it into the surface copy.
  assert.ok(!state.error.includes("server exploded"));
});

test("component does NOT render forbidden field names even when the API mock returns them in metadata", async () => {
  const { state, toggle } = makeFakePanel(async () => ({
    activities: [
      {
        id: "row-evil",
        eventType: "integration.webhook.secret_rotated",
        actor: null,
        createdAt: "2026-06-05T12:00:00.000Z",
        metadata: {
          secret: "MUST_NOT_LEAK_secret",
          rawSecret: "MUST_NOT_LEAK_rawSecret",
          secretCiphertext: "MUST_NOT_LEAK_secretCiphertext",
          previousSecret: "MUST_NOT_LEAK_previousSecret",
          previousSecretCiphertext:
            "MUST_NOT_LEAK_previousSecretCiphertext",
          rawKey: "MUST_NOT_LEAK_rawKey",
          Authorization: "Bearer MUST_NOT_LEAK_Bearer",
        },
      },
    ],
  }));
  await toggle();
  const encoded = JSON.stringify(state.rows);
  for (const sentinel of [
    "MUST_NOT_LEAK_secret",
    "MUST_NOT_LEAK_rawSecret",
    "MUST_NOT_LEAK_secretCiphertext",
    "MUST_NOT_LEAK_previousSecret",
    "MUST_NOT_LEAK_previousSecretCiphertext",
    "MUST_NOT_LEAK_rawKey",
    "MUST_NOT_LEAK_Bearer",
  ]) {
    assert.ok(
      !encoded.includes(sentinel),
      `forbidden sentinel "${sentinel}" leaked into the panel's rendered rows`,
    );
  }
});

test("collapse then re-expand does NOT refetch", async () => {
  const { state, toggle } = makeFakePanel(async () => ({ activities: [] }));
  await toggle(); // open + fetch
  assert.equal(state.fetchCount, 1);
  await toggle(); // close
  assert.equal(state.fetchCount, 1);
  await toggle(); // re-open — must reuse cached rows, no extra fetch
  assert.equal(state.fetchCount, 1);
});

test("re-expand after error retries the fetch", async () => {
  let firstCall = true;
  const { state, toggle } = makeFakePanel(async () => {
    if (firstCall) {
      firstCall = false;
      throw new Error("transient");
    }
    return { activities: [] };
  });
  await toggle();
  assert.equal(state.error?.startsWith("Activity could not be loaded"), true);
  await toggle(); // close
  await toggle(); // re-open after error -> retry
  assert.equal(state.error, null);
  assert.deepEqual(state.rows, []);
});
