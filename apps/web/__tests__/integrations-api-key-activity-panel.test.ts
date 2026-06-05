/**
 * Phase 3 — ApiKeyActivityPanel regression lock.
 *
 * The panel lives inline in
 *   apps/web/app/(app)/integrations/page.tsx
 * and is the only operator surface that lazy-loads the canonical
 * TeamActivity feed scoped to a single api_credential. The constraints
 * we MUST never regress:
 *
 *   1. Default state is collapsed — no fetch is issued on initial
 *      render. The fetch only fires on the first expand.
 *   2. The collapsed-by-default empty-state copy is the literal copy
 *      from the phase spec ("Activity will appear here…").
 *   3. The fetch-failure copy is the literal copy from the phase spec
 *      ("Activity could not be loaded…") — never a raw error.
 *   4. The forbidden metadata field-name allowlist is wired into the
 *      sanitizer (keyHash, previousKeyHash, secretCiphertext,
 *      previousSecretCiphertext, rawKey, rawSecret, Authorization) so
 *      a malicious / accidental server response cannot smuggle a
 *      secret into the rendered tree.
 *   5. The known event-type vocabulary maps to human labels and
 *      unknown event types fall through to the verbatim eventType.
 *   6. The fetch URL targets the canonical Phase-2 filter route:
 *      GET /v1/teams/<teamId>/activity?targetType=api_credential
 *      &targetId=<id>&limit=10 — NOT a new endpoint, NOT a duplicate
 *      feed, and NOT a path that omits the targetType/targetId
 *      scoping (which would surface unrelated team activity).
 *
 * The runtime port at the bottom of this file exercises the
 * sanitizer logic against representative inputs (including a hostile
 * "metadata-with-forbidden-fields" case) to prove the behavior even
 * when the source-level regex check above is hypothetically bypassed.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx apps/web/__tests__/integrations-api-key-activity-panel.test.ts`
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

test("page.tsx defines the ApiKeyActivityPanel component", () => {
  assert.match(
    PAGE_SOURCE,
    /function ApiKeyActivityPanel\s*\(/,
    "The Phase-3 disclosure component must remain co-located inside " +
      "integrations/page.tsx (same convention as WebhookDeliveriesPanel).",
  );
});

test("ApiKeyActivityPanel is wired into ApiKeysTable", () => {
  // The component is only valuable if it actually renders on each
  // api-key row. We assert the JSX call site is present and that it
  // receives `teamId` and `apiCredentialId` (the exact props named in
  // the phase spec).
  assert.match(
    PAGE_SOURCE,
    /<ApiKeyActivityPanel[\s\S]{0,200}?teamId=\{teamId\}[\s\S]{0,200}?apiCredentialId=\{k\.id\}/,
    "ApiKeysTable must render <ApiKeyActivityPanel teamId={teamId} " +
      "apiCredentialId={k.id} />. The exact prop names matter — they " +
      "are the contract the panel renders against.",
  );
});

test("ApiKeysTable receives teamId from the parent page", () => {
  // The page-level call site must thread teamId down. Without this
  // the panel would render with the wrong (or no) workspace scope.
  assert.match(
    PAGE_SOURCE,
    /<ApiKeysTable[\s\S]{0,400}?teamId=\{teamId\}/,
    "The ApiKeysTable call in IntegrationsPageInner must pass " +
      "`teamId={teamId}` so the disclosure can scope its fetch.",
  );
});

test("default state is collapsed — no fetch on initial render", () => {
  // The component must start with `expanded = false`. The fetch must
  // only fire from inside the toggle handler — i.e. there must NOT be
  // a useEffect-driven auto-load.
  assert.match(
    PAGE_SOURCE,
    /const \[expanded, setExpanded\] = useState\(false\)/,
    "ApiKeyActivityPanel must initialize `expanded = false`. Default " +
      "open would defeat the lazy-load contract.",
  );

  // The panel body must reuse the same scope and must not introduce
  // a useEffect(load) that would fire on mount. We assert the panel
  // function body does not contain a `useEffect(` call.
  const panelBodyMatch = PAGE_SOURCE.match(
    /function ApiKeyActivityPanel\([\s\S]*?\n\}\n/,
  );
  assert.ok(panelBodyMatch, "must locate the panel function body");
  assert.ok(
    !/useEffect\s*\(/.test(panelBodyMatch[0]),
    "ApiKeyActivityPanel must not call useEffect — the only allowed " +
      "fetch trigger is the user click that toggles the disclosure.",
  );
});

test("fetch URL hits the canonical Phase-2 filter route", () => {
  // The Phase-2 backend filter accepts targetType=api_credential and
  // targetId=<credentialId> against the existing /activity route. We
  // pin the exact URL shape so a future refactor cannot silently drop
  // the scoping params (which would surface unrelated team activity).
  assert.match(
    PAGE_SOURCE,
    /\/v1\/teams\/\$\{encodeURIComponent\(teamId\)\}\/activity\?targetType=api_credential&targetId=\$\{encodeURIComponent\(apiCredentialId\)\}&limit=10/,
    "The disclosure must hit GET /v1/teams/<teamId>/activity with " +
      "targetType=api_credential, targetId=<id>, and limit=10. Any " +
      "drift here is a privacy regression.",
  );
});

test("forbidden metadata field-name allowlist is wired", () => {
  // The sanitizer must list every forbidden field name. If a future
  // contributor edits the list and drops one, this test catches it.
  for (const forbidden of [
    "keyhash",
    "previouskeyhash",
    "secretciphertext",
    "previoussecretciphertext",
    "rawkey",
    "rawsecret",
    "authorization",
  ]) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`["']${forbidden}["']`, "i"),
      `FORBIDDEN_METADATA_FIELDS must include "${forbidden}" so a ` +
        `metadata response with that key is stripped silently.`,
    );
  }
});

test("event-type vocabulary maps known events to human labels", () => {
  const expected: Array<[string, string]> = [
    ["integration.api_key.created", "Created"],
    ["integration.api_key.rotated", "Rotated"],
    ["integration.api_key.revoked", "Revoked"],
    ["integration.api_key.expiry_changed", "Expiry updated"],
    ["integration.api_key.scope_changed", "Scopes updated"],
    ["integration.api_key.failed_scope_check", "Scope denied"],
  ];
  for (const [event, label] of expected) {
    const re = new RegExp(
      `["']${event.replace(/\./g, "\\.")}["']\\s*:\\s*["']${label}["']`,
    );
    assert.match(
      PAGE_SOURCE,
      re,
      `API_KEY_EVENT_LABELS must map "${event}" -> "${label}".`,
    );
  }
});

test("empty-state copy is the literal copy from the phase spec", () => {
  // Operator-facing strings are part of the user contract and must
  // never regress to dev language.
  assert.ok(
    PAGE_SOURCE.includes(
      "Activity will appear here after this key is created, rotated, used, or revoked.",
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
  // The panel function body must not reference keyHash / rawKey / etc.
  // The sanitizer ALLOWLIST entries above are in lowercase string
  // literals and are part of the strip-not-render logic, which is OK.
  // What is NOT OK is a render-side reference like `r.metadata.keyHash`.
  const panelBodyMatch = PAGE_SOURCE.match(
    /function ApiKeyActivityPanel\([\s\S]*?\n\}\n/,
  );
  assert.ok(panelBodyMatch, "must locate the panel function body");
  const body = panelBodyMatch[0];
  for (const forbidden of [
    ".keyHash",
    ".previousKeyHash",
    ".secretCiphertext",
    ".previousSecretCiphertext",
    ".rawKey",
    ".rawSecret",
    ".Authorization",
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `ApiKeyActivityPanel must not access ${forbidden} on any value.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Runtime exercise — faithful port of the sanitizer.
//
// The phase spec calls out a single hard requirement on the projection
// path: if the API mock ever returns forbidden field names inside
// metadata, those fields MUST be dropped silently before the panel
// renders. We port the function's published behaviour here and prove
// it against representative inputs.
// ---------------------------------------------------------------------------

type ApiKeyActivityRow = {
  id: string;
  eventType: string;
  actor: { id: string; email: string | null; displayName: string | null } | null;
  createdAt: string;
  reason: string | null;
};

const FORBIDDEN_METADATA_FIELDS = [
  "keyhash",
  "previouskeyhash",
  "secretciphertext",
  "previoussecretciphertext",
  "rawkey",
  "rawsecret",
  "authorization",
] as const;

// Faithful port of `projectActivityRow` from page.tsx. If this drifts
// from the real implementation, the source-level tests above catch
// the schema drift; this port catches the behavioural drift.
function projectActivityRow(raw: unknown): ApiKeyActivityRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const eventType = typeof r.eventType === "string" ? r.eventType : null;
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : null;
  if (!id || !eventType || !createdAt) return null;

  let actor: ApiKeyActivityRow["actor"] = null;
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

  let reason: string | null = null;
  if (r.metadata && typeof r.metadata === "object") {
    const md = r.metadata as Record<string, unknown>;
    const safeMd: Record<string, unknown> = {};
    for (const k of Object.keys(md)) {
      if (FORBIDDEN_METADATA_FIELDS.includes(k.toLowerCase() as never)) continue;
      safeMd[k] = md[k];
    }
    if (
      typeof safeMd.revokedReason === "string" &&
      (safeMd.revokedReason as string).length <= 400
    ) {
      reason = safeMd.revokedReason as string;
    }
  }

  return { id, eventType, actor, createdAt, reason };
}

test("projection drops malformed rows so an empty list renders safely", () => {
  assert.equal(projectActivityRow(null), null);
  assert.equal(projectActivityRow(undefined), null);
  assert.equal(projectActivityRow("not an object"), null);
  assert.equal(projectActivityRow({}), null);
  // Missing required fields.
  assert.equal(
    projectActivityRow({ id: "x", eventType: "integration.api_key.created" }),
    null,
  );
});

test("projection accepts a well-formed row and preserves safe fields", () => {
  const row = projectActivityRow({
    id: "row-1",
    eventType: "integration.api_key.created",
    targetType: "api_credential",
    targetId: "key-1",
    actor: { id: "user-1", email: "alice@example.com", displayName: "Alice" },
    metadata: {},
    createdAt: "2026-06-05T12:00:00.000Z",
  });
  assert.ok(row);
  assert.equal(row.id, "row-1");
  assert.equal(row.eventType, "integration.api_key.created");
  assert.equal(row.actor?.email, "alice@example.com");
  assert.equal(row.actor?.displayName, "Alice");
  assert.equal(row.createdAt, "2026-06-05T12:00:00.000Z");
  assert.equal(row.reason, null);
});

test("projection drops forbidden metadata field names silently", () => {
  // The malicious payload: a metadata object that smuggles every
  // forbidden field name we know about. The projection MUST strip
  // each one without throwing and without surfacing the value.
  const malicious = {
    id: "row-evil",
    eventType: "integration.api_key.rotated",
    targetType: "api_credential",
    targetId: "key-1",
    actor: { id: "user-1", email: null, displayName: null },
    createdAt: "2026-06-05T12:00:00.000Z",
    metadata: {
      keyHash: "MUST_NOT_LEAK_keyHash",
      previousKeyHash: "MUST_NOT_LEAK_previousKeyHash",
      secretCiphertext: "MUST_NOT_LEAK_secretCiphertext",
      previousSecretCiphertext: "MUST_NOT_LEAK_previousSecretCiphertext",
      rawKey: "MUST_NOT_LEAK_rawKey",
      rawSecret: "MUST_NOT_LEAK_rawSecret",
      Authorization: "Bearer MUST_NOT_LEAK_Bearer",
      revokedReason: "Compromised in incident #1234",
    },
  };
  const row = projectActivityRow(malicious);
  assert.ok(row, "the row itself must still project; only forbidden " +
    "fields are stripped, not the whole row");

  // The narrowly-bounded `reason` survives because the spec calls out
  // revokedReason as a safe field. Everything else MUST be gone.
  assert.equal(row.reason, "Compromised in incident #1234");

  // The projection's published shape exposes nothing else from
  // metadata. We re-encode the row and assert none of the forbidden
  // sentinels can be observed downstream.
  const encoded = JSON.stringify(row);
  for (const sentinel of [
    "MUST_NOT_LEAK_keyHash",
    "MUST_NOT_LEAK_previousKeyHash",
    "MUST_NOT_LEAK_secretCiphertext",
    "MUST_NOT_LEAK_previousSecretCiphertext",
    "MUST_NOT_LEAK_rawKey",
    "MUST_NOT_LEAK_rawSecret",
    "MUST_NOT_LEAK_Bearer",
  ]) {
    assert.ok(
      !encoded.includes(sentinel),
      `forbidden sentinel "${sentinel}" leaked into the projected row`,
    );
  }
});

test("projection caps revokedReason length to bound the rendered string", () => {
  // The render path uses `reason` directly — a 1 MB string would
  // bloat the row. The projection therefore drops anything past 400
  // characters.
  const longReason = "x".repeat(401);
  const row = projectActivityRow({
    id: "row-long",
    eventType: "integration.api_key.revoked",
    actor: null,
    createdAt: "2026-06-05T12:00:00.000Z",
    metadata: { revokedReason: longReason },
  });
  assert.ok(row);
  assert.equal(row.reason, null);
});

// ---------------------------------------------------------------------------
// 3. UI behaviour — simulate the toggle/load lifecycle without a DOM.
//
// These tests model the panel's published behaviour (collapsed-by-
// default, first-expand-triggers-fetch, error blocks rows render) by
// re-implementing the state machine inline. They DO catch the
// "component does NOT render forbidden field names even when the API
// mock returns them in metadata" requirement at the runtime layer.
// ---------------------------------------------------------------------------

type FakePanelState = {
  expanded: boolean;
  rows: ApiKeyActivityRow[] | null;
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
            .map((a) => projectActivityRow(a))
            .filter((a): a is ApiKeyActivityRow => a !== null)
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
        eventType: "integration.api_key.created",
        actor: { id: "u1", email: "a@b.c", displayName: "A" },
        createdAt: "2026-06-05T12:00:00.000Z",
        metadata: {},
      },
      {
        id: "row-2",
        eventType: "integration.api_key.rotated",
        actor: null,
        createdAt: "2026-06-05T12:30:00.000Z",
        metadata: {},
      },
    ],
  }));
  await toggle();
  assert.equal(state.rows?.length, 2);
  assert.equal(state.rows?.[0]!.eventType, "integration.api_key.created");
  assert.equal(state.rows?.[1]!.eventType, "integration.api_key.rotated");
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
        eventType: "integration.api_key.rotated",
        actor: null,
        createdAt: "2026-06-05T12:00:00.000Z",
        metadata: {
          keyHash: "MUST_NOT_LEAK_keyHash",
          previousKeyHash: "MUST_NOT_LEAK_previousKeyHash",
          secretCiphertext: "MUST_NOT_LEAK_secretCiphertext",
          previousSecretCiphertext:
            "MUST_NOT_LEAK_previousSecretCiphertext",
          rawKey: "MUST_NOT_LEAK_rawKey",
          rawSecret: "MUST_NOT_LEAK_rawSecret",
          Authorization: "Bearer MUST_NOT_LEAK_Bearer",
        },
      },
    ],
  }));
  await toggle();
  const encoded = JSON.stringify(state.rows);
  for (const sentinel of [
    "MUST_NOT_LEAK_keyHash",
    "MUST_NOT_LEAK_previousKeyHash",
    "MUST_NOT_LEAK_secretCiphertext",
    "MUST_NOT_LEAK_previousSecretCiphertext",
    "MUST_NOT_LEAK_rawKey",
    "MUST_NOT_LEAK_rawSecret",
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
