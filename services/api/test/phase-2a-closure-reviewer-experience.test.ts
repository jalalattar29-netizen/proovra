/**
 * Phase 2A Closure — Reviewer Experience contract test.
 *
 * Pins the experience-layer surfaces shipped on top of the Phase 2A
 * foundation:
 *
 *   1. Annotation threading column on EvidenceAnnotation
 *   2. Annotation-workspace service + bulk-resolve
 *   3. Bulk operations service + routes (assign, decide, code)
 *   4. Advanced viewers (Image / PDF / Video / Audio)
 *   5. Side-pane mode switcher + AnnotationPanel
 *   6. Workspace page wires MediaViewer + auto-next + help overlay
 *   7. Queues page with multi-select + bulk action bar + confirmation
 *   8. Pillar nav contains the new queues route
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const ANNOTATION_SVC = readSource(
  "../../../services/api/src/services/reviewer-workspace/annotation-workspace.service.ts",
);
const BULK_SVC = readSource(
  "../../../services/api/src/services/reviewer-workspace/bulk-operations.service.ts",
);
const ROUTES = readSource(
  "../../../services/api/src/routes/reviewer-workspace.routes.ts",
);
const IMG_VIEW = readSource(
  "../../../apps/web/components/reviewer-workspace/viewers/ImageViewer.tsx",
);
const PDF_VIEW = readSource(
  "../../../apps/web/components/reviewer-workspace/viewers/PdfViewer.tsx",
);
const VID_VIEW = readSource(
  "../../../apps/web/components/reviewer-workspace/viewers/VideoViewer.tsx",
);
const AUD_VIEW = readSource(
  "../../../apps/web/components/reviewer-workspace/viewers/AudioViewer.tsx",
);
const MEDIA_VIEW = readSource(
  "../../../apps/web/components/reviewer-workspace/viewers/MediaViewer.tsx",
);
const SIDE_PANE = readSource(
  "../../../apps/web/components/reviewer-workspace/SidePaneSwitcher.tsx",
);
const ANNO_PANEL = readSource(
  "../../../apps/web/components/reviewer-workspace/AnnotationPanel.tsx",
);
const WS_PAGE = readSource(
  "../../../apps/web/app/(app)/review/workspace/page.tsx",
);
const QUEUES_PAGE = readSource(
  "../../../apps/web/app/(app)/review/queues/page.tsx",
);
const REVIEWER_API = readSource(
  "../../../apps/web/lib/reviewer-workspace/reviewer-api.ts",
);
const PILLAR_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/pillarRegistry.ts",
);
const ROUTE_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/routeRegistry.ts",
);

describe("Phase 2A Closure — Prisma annotation threading", () => {
  it("EvidenceAnnotation carries parentAnnotationId", () => {
    const block = SCHEMA.match(/^model EvidenceAnnotation \{[\s\S]*?\n\}/m)![0];
    expect(block).toContain("parentAnnotationId");
    expect(block).toContain('@map("parent_annotation_id")');
    expect(block).toMatch(/@@index\(\[parentAnnotationId\]\)/);
    expect(block).toMatch(/AnnotationThread/);
  });
});

describe("Phase 2A Closure — annotation-workspace service", () => {
  it("exports the bounded surface (list, reply, resolve, bulk-resolve)", () => {
    expect(ANNOTATION_SVC).toMatch(/export\s+async\s+function\s+listAnnotationsForEvidence/);
    expect(ANNOTATION_SVC).toMatch(/export\s+async\s+function\s+postAnnotationReply/);
    expect(ANNOTATION_SVC).toMatch(/export\s+async\s+function\s+resolveAnnotation/);
    expect(ANNOTATION_SVC).toMatch(/export\s+async\s+function\s+bulkResolveAnnotations/);
  });
  it("enforces one-level nesting + bulk cap", () => {
    expect(ANNOTATION_SVC).toMatch(/ANNOTATION_NESTING_INVALID/);
    expect(ANNOTATION_SVC).toMatch(/BULK_SET_TOO_LARGE/);
  });
});

describe("Phase 2A Closure — bulk operations service", () => {
  it("exports bulkAssign, bulkDecide, bulkCode", () => {
    expect(BULK_SVC).toMatch(/export\s+async\s+function\s+bulkAssign/);
    expect(BULK_SVC).toMatch(/export\s+async\s+function\s+bulkDecide/);
    expect(BULK_SVC).toMatch(/export\s+async\s+function\s+bulkCode/);
  });
  it("enforces bounded batch size (≤ 100)", () => {
    expect(BULK_SVC).toMatch(/MAX_BULK\s*=\s*100/);
  });
  it("returns per-item outcomes (does not abort the batch)", () => {
    expect(BULK_SVC).toMatch(/BulkItemOutcome/);
  });
});

describe("Phase 2A Closure — routes", () => {
  for (const path of [
    '"/v1/reviewer/evidence/:evidenceId/annotations"',
    '"/v1/reviewer/annotations/:id/reply"',
    '"/v1/reviewer/annotations/:id/resolve"',
    '"/v1/reviewer/annotations/bulk-resolve"',
    '"/v1/reviewer/bulk/assign"',
    '"/v1/reviewer/bulk/decide"',
    '"/v1/reviewer/bulk/code"',
  ]) {
    it(`registers ${path}`, () => {
      expect(ROUTES).toContain(path);
    });
  }
  it("requires review.bulk + the per-action capability", () => {
    expect(ROUTES).toMatch(/requireCap\(ctx,\s*"review\.bulk"\)/);
    expect(ROUTES).toMatch(/requireCap\(ctx,\s*"review\.assign"\)/);
    expect(ROUTES).toMatch(/requireCap\(ctx,\s*"review\.decide"\)/);
    expect(ROUTES).toMatch(/requireCap\(ctx,\s*"review\.code"\)/);
  });
});

describe("Phase 2A Closure — viewer components", () => {
  it("ImageViewer surfaces zoom / rotate / metadata + annotation overlays", () => {
    expect(IMG_VIEW).toMatch(/data-image-viewer/);
    expect(IMG_VIEW).toMatch(/data-image-toolbar/);
    expect(IMG_VIEW).toMatch(/data-image-annotation-overlay/);
    expect(IMG_VIEW).toMatch(/data-image-metadata-panel/);
  });
  it("PdfViewer has page navigation + annotation rail", () => {
    expect(PDF_VIEW).toMatch(/data-pdf-toolbar/);
    expect(PDF_VIEW).toMatch(/data-pdf-page-input/);
    expect(PDF_VIEW).toMatch(/data-pdf-annotation-rail/);
  });
  it("VideoViewer has frame stepping + timeline markers", () => {
    expect(VID_VIEW).toMatch(/video-frame-back/);
    expect(VID_VIEW).toMatch(/video-frame-fwd/);
    expect(VID_VIEW).toMatch(/data-video-timeline-marker/);
  });
  it("AudioViewer has timeline + transcript-sync rail", () => {
    expect(AUD_VIEW).toMatch(/data-audio-timeline-marker/);
    expect(AUD_VIEW).toMatch(/data-audio-transcript-segment/);
  });
  it("MediaViewer dispatches by inferred kind + honest unknown fallback", () => {
    expect(MEDIA_VIEW).toMatch(/inferMediaKind/);
    expect(MEDIA_VIEW).toMatch(/data-media-viewer-unknown/);
  });
});

describe("Phase 2A Closure — side-pane switcher + annotation panel", () => {
  it("SidePaneSwitcher declares 6 bounded modes", () => {
    for (const m of [
      "CODING",
      "ANNOTATIONS",
      "OCR",
      "TRANSCRIPT",
      "EVIDENCE",
      "REPORT",
    ]) {
      expect(SIDE_PANE).toContain(`"${m}"`);
    }
    expect(SIDE_PANE).toMatch(/data-side-pane-switcher/);
  });
  it("AnnotationPanel groups replies + supports bulk-resolve", () => {
    expect(ANNO_PANEL).toMatch(/data-annotation-thread/);
    expect(ANNO_PANEL).toMatch(/data-annotation-reply/);
    expect(ANNO_PANEL).toMatch(/data-annotation-bulk-resolve/);
  });
});

describe("Phase 2A Closure — workspace page wiring", () => {
  it("page imports MediaViewer + AnnotationPanel + SidePaneSwitcher", () => {
    expect(WS_PAGE).toMatch(/from\s+"\.\.\/\.\.\/\.\.\/\.\.\/components\/reviewer-workspace\/viewers\/MediaViewer"/);
    expect(WS_PAGE).toMatch(/from\s+"\.\.\/\.\.\/\.\.\/\.\.\/components\/reviewer-workspace\/AnnotationPanel"/);
    expect(WS_PAGE).toMatch(/SidePaneSwitcher/);
  });
  it("workspace auto-advances after a decision (NEXT_ITEM hotkey + advanceToNext)", () => {
    expect(WS_PAGE).toMatch(/advanceToNext/);
    expect(WS_PAGE).toMatch(/NEXT_ITEM/);
  });
  it("workspace renders help overlay on ? key", () => {
    expect(WS_PAGE).toMatch(/data-reviewer-help-overlay/);
  });
  it("legacy iframe-based EvidenceViewer is removed", () => {
    expect(WS_PAGE).not.toMatch(/<iframe[^>]*data-reviewer-viewer/);
    expect(WS_PAGE).toMatch(/EvidenceViewerColumn/);
  });
});

describe("Phase 2A Closure — queues + bulk UI", () => {
  it("queues page provides multi-select + bulk action bar + confirmation", () => {
    expect(QUEUES_PAGE).toMatch(/data-reviewer-queue-table/);
    expect(QUEUES_PAGE).toMatch(/data-reviewer-queue-select-all/);
    expect(QUEUES_PAGE).toMatch(/data-bulk-bar/);
    expect(QUEUES_PAGE).toMatch(/data-bulk-confirm/);
  });
  it("queues page exposes bulk action attributes for every bounded action", () => {
    // Action attrs are emitted via {v} for verdicts (REVIEWER_VERDICTS
    // filter excluding PENDING) and the literal "ASSIGN" for the
    // assign button. Bounded vocabulary lives on the source page.
    expect(QUEUES_PAGE).toMatch(/data-bulk-action="ASSIGN"/);
    expect(QUEUES_PAGE).toMatch(/data-bulk-action=\{v\}/);
    expect(QUEUES_PAGE).toMatch(/REVIEWER_VERDICTS\.filter/);
  });
  it("queues route registered + mapped to the REVIEW pillar", () => {
    expect(ROUTE_REGISTRY).toMatch(/id:\s*"workspace\.review_queues"/);
    expect(PILLAR_REGISTRY).toMatch(/"workspace\.review_queues"[\s,]+"REVIEW"/);
  });
});

describe("Phase 2A Closure — API client", () => {
  it("reviewer-api exposes annotation + bulk helpers", () => {
    expect(REVIEWER_API).toMatch(/fetchAnnotationsForEvidence/);
    expect(REVIEWER_API).toMatch(/fetchEvidencePreview/);
    expect(REVIEWER_API).toMatch(/bulkAssign/);
    expect(REVIEWER_API).toMatch(/bulkDecide/);
    expect(REVIEWER_API).toMatch(/bulkCode/);
  });
});
