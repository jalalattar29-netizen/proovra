/**
 * AUD-0041 — the in-app webhook documentation states the retry policy the
 * dispatcher applies. It said any non-2xx response was retried with backoff;
 * a 4xx other than 408/429 is final (classifyWebhookHttpError). The panel and
 * the classifier are checked against each other here.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyWebhookHttpError } from "@proovra/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(resolve(HERE, "../app/(app)/integrations/page.tsx"), "utf8").replace(/\s+/g, " ");

test("the classifier: 5xx, 408 and 429 are retried; other 4xx are final", () => {
  for (const s of [500, 502, 503, 408, 429]) assert.equal(classifyWebhookHttpError(s, null), "transient", String(s));
  for (const s of [400, 401, 403, 404, 410, 422]) assert.equal(classifyWebhookHttpError(s, null), "permanent", String(s));
});

test("the panel says the same, and no longer promises a retry for any non-2xx", () => {
  assert.doesNotMatch(PAGE, /Any non-2xx response \(or a network error\) marks the delivery as failed and schedules/);
  assert.match(PAGE, /A 5xx response, a 408 or 429, or a network error marks the attempt as failed and schedules an exponential backoff retry\./);
  assert.match(PAGE, /Any other 4xx response is final: the delivery fails at once and is not retried/);
});
