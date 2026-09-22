/**
 * `GET /v1/legal` and `GET /v1/legal/:slug` — the canonical legal delivery.
 *
 * These routes exist so the Native app reads the SAME legal text the web
 * renders, from the SAME source, instead of bundling a copy that goes stale or
 * opening proovra.com in a system browser. What has to hold:
 *
 *   - the served text is byte-identical to the authored markdown;
 *   - the routes answer without a session, because the sign-in screen links
 *     Terms and Privacy and the 428 re-acceptance gate asks a user to accept a
 *     document the client must be able to display;
 *   - an unknown slug is a 404, not a 500 and not a path escape;
 *   - the response carries no metadata the corpus cannot support.
 *
 * `legalRoutes` registers on a bare Fastify instance with no database, no
 * Prisma and no auth decorators — which is itself part of the claim: legal
 * delivery depends on nothing that can be down.
 */

import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { legalRoutes } from "../src/routes/legal.routes.js";
import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CONTENT_DIR = join(REPO_ROOT, "apps", "web", "content", "legal", "en");

const AUTHORED = Object.fromEntries(
  readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => [
      f.slice(0, -3),
      readFileSync(join(CONTENT_DIR, f), "utf8").replace(/\r\n/g, "\n"),
    ]),
);

async function buildLegalApp() {
  const app = Fastify({ logger: false });
  await app.register(legalRoutes);
  await app.ready();
  return app;
}

describe("legal document delivery", () => {
  it("serves every authored document, byte-identical", async () => {
    const app = await buildLegalApp();
    try {
      const slugs = Object.keys(AUTHORED);
      expect(slugs.length).toBeGreaterThan(0);

      for (const slug of slugs) {
        const res = await app.inject({ method: "GET", url: `/v1/legal/${slug}` });
        expect(res.statusCode, `GET /v1/legal/${slug}`).toBe(200);

        const body = res.json();
        expect(body.slug).toBe(slug);
        expect(body.locale).toBe("en");
        expect(body.contentFormat).toBe("markdown");
        expect(typeof body.title).toBe("string");
        expect(body.title.length).toBeGreaterThan(0);
        expect(
          body.content,
          `${slug} differs from apps/web/content/legal/en/${slug}.md`,
        ).toBe(AUTHORED[slug]);
      }
    } finally {
      await app.close();
    }
  });

  it("reports each document's own Last Updated date", async () => {
    const app = await buildLegalApp();
    try {
      for (const [slug, markdown] of Object.entries(AUTHORED)) {
        const stated = markdown.match(/^Last Updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
        expect(stated, `${slug}.md states no Last Updated date`).toBeTruthy();

        const res = await app.inject({ method: "GET", url: `/v1/legal/${slug}` });
        expect(res.json().lastUpdated).toBe(stated![1]);
      }
    } finally {
      await app.close();
    }
  });

  it("answers without a session", async () => {
    // No auth decorator is registered at all here. A route that had picked up
    // `requireAuth` would throw on registration or 500 on call, not 200.
    const app = await buildLegalApp();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/legal/terms" });
      expect(res.statusCode).toBe(200);
      expect(res.json().content.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("404s an unknown slug and refuses path traversal", async () => {
    const app = await buildLegalApp();
    try {
      for (const slug of [
        "not-a-document",
        "..%2F..%2Fpackage.json",
        "privacy.md",
        "PRIVACY",
        "",
      ]) {
        const res = await app.inject({ method: "GET", url: `/v1/legal/${slug}` });
        expect(
          [404, 400],
          `GET /v1/legal/${slug} answered ${res.statusCode}`,
        ).toContain(res.statusCode);
        expect(res.statusCode).not.toBe(500);
      }
    } finally {
      await app.close();
    }
  });

  it("indexes every document without shipping the bodies", async () => {
    const app = await buildLegalApp();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/legal" });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.locale).toBe("en");
      expect(body.documents.map((d: { slug: string }) => d.slug).sort()).toEqual(
        Object.keys(AUTHORED).sort(),
      );
      for (const doc of body.documents) {
        expect(doc.content).toBeUndefined();
        expect(doc.title).toBeTruthy();
        expect(doc.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    } finally {
      await app.close();
    }
  });

  it("reports acceptance versions from the acceptance authority, for those policies only", async () => {
    const app = await buildLegalApp();
    try {
      for (const [key, version] of Object.entries(REQUIRED_LEGAL_VERSIONS)) {
        const res = await app.inject({ method: "GET", url: `/v1/legal/${key}` });
        expect(res.json().acceptance).toEqual({
          policyKey: key,
          requiredVersion: version,
        });
      }

      // A document the acceptance gate does not govern must not be given an
      // invented version.
      const other = await app.inject({ method: "GET", url: "/v1/legal/dpa" });
      expect(other.json().acceptance).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("carries no document metadata the corpus cannot support", async () => {
    const app = await buildLegalApp();
    try {
      const body = await app
        .inject({ method: "GET", url: "/v1/legal/privacy" })
        .then((r) => r.json());

      expect(Object.keys(body).sort()).toEqual(
        [
          "acceptance",
          "content",
          "contentFormat",
          "lastUpdated",
          "locale",
          "slug",
          "title",
        ].sort(),
      );
    } finally {
      await app.close();
    }
  });
});
