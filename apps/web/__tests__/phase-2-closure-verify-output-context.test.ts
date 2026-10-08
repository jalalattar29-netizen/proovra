/**
 * PROOVRA Phase 2 closure — verify page renders the canonical
 * OutputContext under the verdict card.
 *
 * Source-pin: prove the page consumes
 * `response.outputContext` and renders the canonical badge so a
 * future refactor cannot silently drop the snapshot vs live label.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(__dirname, "..", "app", "verify", "[token]", "page.tsx");

test("verify page declares OutputContextBadge component", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(
    /function OutputContextBadge\(/.test(src),
    "OutputContextBadge component must be declared",
  );
});

test("verify page renders OutputContextBadge under TrustDecisionCard", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(
    /<OutputContextBadge outputContext=\{outputContext\}/.test(src),
    "OutputContextBadge must be conditionally rendered with outputContext prop",
  );
});

test("verify page wires outputContext from VerifyResponse into state", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(
    /useState<VerifyResponse\["outputContext"\]>/.test(src),
    "useState must be typed against VerifyResponse[\"outputContext\"]",
  );
  assert.ok(
    /setOutputContext\(data\.outputContext \?\? null\)/.test(src),
    "applyVerifyResponse must set outputContext from the API response",
  );
});

test("OutputContextBadge exposes data-testid for downstream assertions", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(
    /data-testid="output-context-badge"/.test(src),
    "OutputContextBadge must carry data-testid='output-context-badge'",
  );
});

test("OutputContextBadge renders canonical legal boundary from outputContext.legalBoundary", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(
    /data-testid="output-context-legal-boundary"/.test(src),
    "Legal-boundary line must carry data-testid='output-context-legal-boundary'",
  );
  assert.ok(
    /\{outputContext\.legalBoundary\}/.test(src),
    "Legal-boundary line must render outputContext.legalBoundary directly (canonical source)",
  );
});

test("no overall verdict label is authored on the page — the headline is the matrix summary", () => {
  const src = readFileSync(PAGE, "utf8");
  // 2026-10-08 — the verdict-label helpers were retired with the score; the
  // page states the bounded matrix summary instead of a verdict headline.
  assert.doesNotMatch(src, /getTrustDecisionLabel|getTrustDecisionConfidenceLabel|getTrustNarrative/);
  assert.doesNotMatch(src, /"Recorded integrity verified; Bitcoin anchoring pending"/);
  assert.match(src, /<VerificationSummaryCard matrix=\{verificationMatrix\} decision=\{trustDecision\} \/>/);
  const panels = readFileSync(PAGE.replace(/page\.tsx$/, "VerifyMatrixPanels.tsx"), "utf8");
  assert.match(panels, /\{matrixSummarySentence\(matrix\)\}/);
  assert.doesNotMatch(panels, /getTrustDecisionLabel|getTrustDecisionConfidenceLabel|getTrustNarrative/);
});
