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

test("hardcoded 'Recorded integrity verified; Bitcoin anchoring pending' now defers to canonical label", () => {
  const src = readFileSync(PAGE, "utf8");
  // The string still exists as the LEGACY-only fallback (when no
  // trustDecision was provided). The Phase 2 closure invariant is
  // that it is preceded by a getTrustDecisionLabel(input.trustDecision)
  // canonical branch.
  const labelBlock = src.match(
    /input\.trustDecision\s*\?\s*getTrustDecisionLabel\(input\.trustDecision\)[\s\S]{0,300}"Recorded integrity verified; Bitcoin anchoring pending"/,
  );
  assert.ok(
    labelBlock,
    "the legacy label must only appear as the else-branch of a canonical getTrustDecisionLabel call",
  );
});
