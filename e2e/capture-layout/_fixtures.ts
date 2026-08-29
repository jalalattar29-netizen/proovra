/**
 * Capture layout gate — fixtures.
 *
 * The API is intercepted and only the web tier is real, the same contract
 * every other `*-layout` project here follows. What this gate measures —
 * whether the page overflows at 390px, whether the readiness verdict on screen
 * can disagree with the Review & Sign button, whether the activity disclosure
 * opens — are cascade, geometry and DOM-state facts. None of them lives in a
 * database, and jsdom answers 0 to every one of them.
 *
 * The platform envelope is imported from the attention fixture rather than
 * re-declared: it carries the accepted schema versions, and an envelope with
 * the wrong ones is refused by `versionsAreCompatible`, after which the shell
 * renders its unknown-projection state — which looks exactly like a layout
 * bug. One definition, one place to update.
 */

import type { Page } from "@playwright/test";

import { envelopeFor } from "../attention-layout/_fixtures";

/**
 * The capture route gate requires `EVIDENCE_CAPTURE`
 * (`routeRegistry.ts` → `workspace.capture`). The attention fixture's
 * contexts are built for a different surface and do not grant it, so the shell
 * rendered "Permission required" and every assertion here timed out against a
 * page that had never mounted. Granted explicitly, and only this one: the
 * project measures layout, not authorization.
 */
function captureEnvelope(): Record<string, unknown> {
  const base = envelopeFor("team-admin") as Record<string, unknown>;
  return {
    ...base,
    capabilities: {
      ...(base.capabilities as Record<string, boolean>),
      EVIDENCE_CAPTURE: true,
    },
  };
}

const SELF_USER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A DRAFT capture session, in the shape `GET /v1/capture/sessions/:id`
 * actually returns — `toApiSession` in `capture.routes.ts`. The fields that
 * matter to resume are `useLocation` and `items` (the server's
 * `itemsSnapshot`), because those are the two the resume path used to fetch
 * and then discard.
 */
export const DRAFT_ID = "draft-11111111-1111-4111-8111-111111111111";

export function captureDraftFixture() {
  return {
    id: DRAFT_ID,
    status: "DRAFT",
    templateId: "general-evidence-record",
    templateVersion: 1,
    templateName: "General Evidence Record",
    planMode: "CHECKLIST_REQUIRED",
    templateSnapshot: null,
    internalNotes: "Insurer reference 88213.",
    useLocation: true,
    items: [
      {
        clientItemId: "item-1",
        fileName: "front-door-damage.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 182_311,
        relativePath: null,
        role: "PRIMARY",
        privateNote: null,
        checklistStepId: "primary_evidence",
        sourceLabel: "Camera",
        uploadState: "pending",
      },
      {
        clientItemId: "item-2",
        fileName: "loss-context.pdf",
        mimeType: "application/pdf",
        sizeBytes: 44_120,
        relativePath: null,
        role: null,
        privateNote: null,
        checklistStepId: null,
        sourceLabel: null,
        uploadState: "pending",
      },
    ],
    uploadState: null,
    finalizedEvidenceId: null,
    finalizedAtUtc: null,
    discardedAtUtc: null,
    expiresAtUtc: "2026-12-31T00:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:30:00.000Z",
  };
}

export async function installCaptureApi(
  page: Page,
  opts: { drafts?: boolean } = {},
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // NOTHING REACHES THE REAL API HOST. The web bundle inlines
  // NEXT_PUBLIC_API_BASE at build time and it defaults to production, so a
  // probe that slips past the `/v1/` pattern — `/admin/runtime/readiness`
  // has no `/v1/` in it — would otherwise leave this machine. Registered
  // first so the specific handlers below take precedence over it.
  //
  // The body is the SHELL-WIDE superset, not a bare envelope.
  // `useGlobalRuntimeState` reads `readiness.subsystems.filter(...)` with no
  // guard, so a readiness response missing that array throws during render and
  // takes the whole app — Capture included — into its error boundary; a layout
  // gate would then be measuring an error page. Every plural field the global
  // shell reads is present and empty.
  await page.route("**/api.proovra.com/**", (route) =>
    route.fulfill(
      json({
        status: "HEALTHY",
        ranAtUtc: "2026-01-01T00:00:00.000Z",
        subsystems: [],
        incidents: [],
        escalations: [],
        items: [],
        data: null,
      }),
    ),
  );

  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/v1/platform/context")) {
      // A shared workspace on a plan that includes capture; the page's own
      // gating is not what this project measures.
      return route.fulfill(json(captureEnvelope()));
    }

    // The shell's own reads, each in the ARRAY-BEARING shape its consumer
    // expects. A bare `{}` is what put the page in its 500 boundary: a
    // consumer calling `.filter` on a field the fixture never sent throws
    // before Capture renders, and a layout gate then measures an error page.
    if (path.endsWith("/v1/capture/intake-templates")) {
      return route.fulfill(json({ templates: [] }));
    }
    if (path.includes("/v1/capture/sessions")) {
      if (!opts.drafts) return route.fulfill(json({ sessions: [] }));
      // The read route answers `{ session }`; the list answers `{ sessions }`.
      if (path.endsWith(`/v1/capture/sessions/${DRAFT_ID}`)) {
        return route.fulfill(json({ session: captureDraftFixture() }));
      }
      return route.fulfill(json({ sessions: [captureDraftFixture()] }));
    }
    if (path.endsWith("/v1/users/me")) {
      return route.fulfill(
        json({ id: SELF_USER_ID, email: "operator@example.invalid", roles: [] }),
      );
    }
    if (path.endsWith("/v1/me/inbox/summary")) {
      return route.fulfill(
        json({ unread: 0, critical: 0, high: 0, total: 0, items: [] }),
      );
    }
    if (path.endsWith("/v1/billing/overview")) {
      return route.fulfill(
        json({ plan: "TEAM", invoices: [], payments: [], subscriptions: [], items: [] }),
      );
    }
    if (path.includes("/v1/ops/incidents")) {
      return route.fulfill(json({ items: [], incidents: [], nextCursor: null }));
    }

    // Anything else: every plural field the app might read, empty.
    return route.fulfill(
      json({
        items: [],
        data: null,
        templates: [],
        sessions: [],
        events: [],
        results: [],
        subsystems: [],
        incidents: [],
        escalations: [],
      }),
    );
  });

  await page.route("**/auth/**", (route) =>
    route.fulfill(
      json({ user: { id: SELF_USER_ID, email: "operator@example.invalid" } }),
    ),
  );
}

/** Open /capture with the API intercepted, and wait for the shell to settle. */
export async function openCapture(
  page: Page,
  opts: { drafts?: boolean } = {},
): Promise<void> {
  await installCaptureApi(page, opts);
  await page.goto("/capture");
  await page.waitForSelector("[data-capture-trust-strip]", { timeout: 30_000 });
}

/** Widths the brief names, plus the one the app must never break at. */
export const WIDTHS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 900 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;
