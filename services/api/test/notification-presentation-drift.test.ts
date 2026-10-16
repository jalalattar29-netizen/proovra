/**
 * The notification presentation authority must know EVERY category the feed
 * can emit.
 *
 * The API owns the `InboxCategory` union; `@proovra/shared`'s
 * `NOTIFICATION_CATEGORIES` owns the reader-facing words for it (bell, page,
 * native app). A category added to one and not the other renders as the
 * generic "Notification" label at best — this pins the two together so the
 * gap is a red test, not a vague chip in production.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CATEGORIES,
  notificationCategoryLabel,
} from "@proovra/shared/i18n";

const ROUTES = readFileSync(
  fileURLToPath(new URL("../src/routes/me-inbox.routes.ts", import.meta.url)),
  "utf8",
);

function apiCategories(): string[] {
  const start = ROUTES.indexOf("type InboxCategory =");
  expect(start).toBeGreaterThan(-1);
  // Comments in the union mention category names (and semicolons) in prose,
  // so they are stripped before the union's own terminating `;` is found.
  const uncommented = ROUTES.slice(start).replace(/\/\/[^\n]*/g, "");
  const body = uncommented.slice(0, uncommented.indexOf(";"));
  return [...body.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

describe("notification presentation ↔ API category union", () => {
  it("every category the API can emit has a presentation entry, and nothing extra", () => {
    expect([...NOTIFICATION_CATEGORIES].sort()).toEqual(apiCategories());
  });

  it("every emitted category resolves to a reviewed label, not the generic fallback", () => {
    for (const category of apiCategories()) {
      for (const locale of ["en", "de", "ar"]) {
        expect(notificationCategoryLabel(locale, category)).not.toBe(
          notificationCategoryLabel(locale, "__unknown__"),
        );
      }
    }
  });
});
