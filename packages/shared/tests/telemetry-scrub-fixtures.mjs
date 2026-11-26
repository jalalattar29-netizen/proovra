/**
 * AUD-022 — the sensitive-value × event-location matrix every Sentry surface
 * (API, worker, web, mobile) is tested against. Each surface feeds every event
 * through its OWN beforeSend and asserts no needle survives.
 *
 * Test-only module (not exported by the package).
 */

/** A sensitive value, the text that carries it, and the needles that must vanish. */
export const SENSITIVE_KINDS = [
  {
    kind: "jwt",
    text: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXNlY3JldC1qd3Q",
    needles: ["eyJzdWIiOiJ1c2VyLTEifQ", "c2lnbmF0dXJlLXNlY3JldC1qd3Q"],
  },
  { kind: "bearer", text: "Authorization: Bearer opaqueBearerCredential7Hq2", needles: ["opaqueBearerCredential7Hq2"] },
  { kind: "cookie", text: "proovra_session=cookieSecretValue9Xk1", needles: ["cookieSecretValue9Xk1"] },
  {
    kind: "signed-url",
    text: "https://bucket.s3.amazonaws.com/evidence/x.pdf?X-Amz-Signature=deadbeefsig1234&X-Amz-Credential=AKIAEXAMPLEKEYID",
    needles: ["deadbeefsig1234", "AKIAEXAMPLEKEYID"],
  },
  {
    kind: "share-url",
    text: "https://app.proovra.com/verify/pvs_shareTokenAbc123456789",
    needles: ["pvs_shareTokenAbc123456789", "shareTokenAbc123456789"],
  },
  {
    kind: "intake-path",
    text: "GET /v1/external-intake/intakeCapability55aa77/files",
    needles: ["intakeCapability55aa77"],
  },
  {
    kind: "oauth-query",
    text: "/auth/callback?code=oauthCodeValue321&state=stateValue654",
    needles: ["oauthCodeValue321", "stateValue654"],
  },
  { kind: "stripe-secret", text: "configured sk_live_51HstripeSecretValue", needles: ["51HstripeSecretValue"] },
  { kind: "email", text: "user jane.doe@example.com failed", needles: ["jane.doe@example.com"] },
  // Sentry alert audit (2026-11-26): what production breadcrumbs actually carried.
  {
    kind: "object-key-file-name (S3 URL)",
    text: "HEAD https://proovra-evidence-prod-eu.s3.eu-central-1.amazonaws.com/evidence/0f5d2c1e-8a3b-4c2d-9e1f-6a7b8c9d0e1f/original-Medical%20report%20Jane%20Smith.pdf",
    needles: ["Medical%20report", "Jane%20Smith", "original-Medical"],
  },
  {
    kind: "object-key-file-name (R2 URL)",
    text: "PUT https://acct.r2.cloudflarestorage.com/proovra-db-backups/reports/0f5d2c1e-8a3b-4c2d-9e1f-6a7b8c9d0e1f/court-bundle-client-x.pdf",
    needles: ["court-bundle-client-x"],
  },
  {
    kind: "object-key-file-name (free text)",
    text: "NoSuchKey: The specified key does not exist: /evidence/0f5d2c1e-8a3b-4c2d-9e1f-6a7b8c9d0e1f/parts/003-holiday-photo-anna.jpg",
    needles: ["holiday-photo-anna"],
  },
  {
    kind: "paypal-resource-id",
    text: "GET https://api-m.paypal.com/v1/billing/subscriptions/I-BW452GLLEP1G",
    needles: ["I-BW452GLLEP1G"],
  },
  { kind: "stripe-resource-id", text: "customer cus_Q7x8Yz12AbCd subscription sub_1PqRsTuVwXyZ", needles: ["cus_Q7x8Yz12AbCd", "sub_1PqRsTuVwXyZ"] },
];

/** Values that are only identifiable by their KEY. */
export const KEYED_SECRETS = {
  password: "hunter2PasswordValue",
  authorization: "Bearer keyedAuthValue",
  cookie: "keyedCookieValue",
  apiKey: "keyedApiKeyValue",
  secret: "keyedSecretValue",
  sessionToken: "keyedSessionTokenValue",
};
export const KEYED_NEEDLES = Object.values(KEYED_SECRETS).map((v) => v.replace(/^Bearer /, ""));

/** One event per location, each carrying `text` there and nowhere else. */
export function eventsCarrying(text) {
  const keyed = { ...KEYED_SECRETS, note: text };
  return [
    [
      "request.url(query)",
      { request: { url: text.includes("://") ? text.slice(text.indexOf("http")) : `https://api.proovra.com/x?q=${encodeURIComponent(text)}` } },
    ],
    ["request.url(path)", { request: { url: `https://api.proovra.com${text.match(/\/[^\s]*/)?.[0] ?? "/"}` } }],
    ["request.headers", { request: { headers: { authorization: text, cookie: text, "x-debug": text, referer: text } } }],
    ["request.cookies", { request: { cookies: { proovra_session: text } } }],
    ["request.data", { request: { data: { body: text, ...keyed } } }],
    ["request.data(string)", { request: { data: text } }],
    ["request.query_string", { request: { query_string: text } }],
    ["message", { message: text }],
    ["logentry", { logentry: { message: text, formatted: text, params: [text] } }],
    ["exception.value", { exception: { values: [{ type: "Error", value: text }] } }],
    ["exception.frame.vars", { exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ vars: keyed, context_line: text }] } }] } }],
    ["breadcrumb.message", { breadcrumbs: [{ category: "console", message: text }] }],
    ["breadcrumb.data", { breadcrumbs: [{ category: "fetch", data: { url: text, ...keyed } }] }],
    ["extra", { extra: { ...keyed, nested: { deeper: [text] } } }],
    ["contexts", { contexts: { app: { ...keyed } } }],
    ["tags", { tags: { note: text } }],
    ["user", { user: { id: "u-1", email: text, username: text, ip_address: "203.0.113.9" } }],
    ["transaction", { transaction: text, type: "transaction" }],
    ["spans", { type: "transaction", spans: [{ description: text, data: { ...keyed } }] }],
  ];
}

/** Assert no needle (and no keyed secret, nor the user IP) survives. */
export function leaks(scrubbed, needles) {
  const json = JSON.stringify(scrubbed ?? null);
  return [...needles, ...KEYED_NEEDLES, "203.0.113.9"].filter((n) => json.includes(n));
}
