/**
 * THE canonical legal document source.
 *
 *     apps/web/content/legal/en/*.md        ← authored, reviewed like code
 *                    │
 *                    │  apps/web/scripts/generate-legal-corpus.mjs
 *                    ▼
 *     @proovra/shared/legal                 ← this module (committed, gated)
 *                    │
 *          ┌─────────┴─────────┐
 *          ▼                   ▼
 *      apps/web            services/api  ──▶  apps/mobile
 *
 * There is ONE authored corpus. The web renderer and `GET /v1/legal/:slug` both
 * derive from it, and neither performs a filesystem read at request time — the
 * API image does not contain `apps/web`, and a `standalone` Next build does not
 * reliably carry files it did not trace.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT CARRY
 * --------------------------------------------
 * A `version` or `effectiveAt` field. The corpus has no such metadata. The one
 * version authority that exists is `REQUIRED_LEGAL_VERSIONS` in
 * `services/api/src/legal/legal-versioning.ts`, which governs *acceptance* for
 * three policies and is not a property of a document. The API composes the two;
 * copying it here would create a second version authority.
 *
 * `lastUpdated` IS carried, because every document states its own
 * `Last Updated:` line and the generator refuses any document that does not.
 */

import { LEGAL_CORPUS, LEGAL_CORPUS_SHA256 } from "./legal/corpus.generated.js";
import {
  LEGAL_DOCUMENT_TITLES,
  LEGAL_LOCALE,
  LEGAL_SLUGS,
  isLegalSlug,
  titleFromSlug,
  type LegalLocale,
  type LegalSlug,
} from "./legal/slugs.js";

export {
  LEGAL_CORPUS_SHA256,
  LEGAL_DOCUMENT_TITLES,
  LEGAL_LOCALE,
  LEGAL_SLUGS,
  isLegalSlug,
  titleFromSlug,
};
export type { LegalLocale, LegalSlug };

/** The wire and render shape of one legal document. */
export type LegalDocument = {
  readonly slug: LegalSlug;
  readonly locale: LegalLocale;
  readonly title: string;
  /** The document's own `Last Updated:` date, `YYYY-MM-DD`. */
  readonly lastUpdated: string;
  readonly contentFormat: "markdown";
  readonly content: string;
};

/** Identity of a document without its body — for an index listing. */
export type LegalDocumentSummary = Omit<LegalDocument, "content" | "contentFormat">;

/**
 * The canonical document for `slug`, or `null` when the slug is not a legal
 * document. Returning `null` rather than throwing lets every caller answer 404
 * for an unknown slug without a try/catch, and keeps an unknown slug from being
 * distinguishable from a known-but-missing one.
 */
export function getLegalDocument(slug: string): LegalDocument | null {
  if (!isLegalSlug(slug)) return null;
  const entry = LEGAL_CORPUS[slug];
  return {
    slug,
    locale: LEGAL_LOCALE,
    title: LEGAL_DOCUMENT_TITLES[slug],
    lastUpdated: entry.lastUpdated,
    contentFormat: "markdown",
    content: entry.markdown,
  };
}

/** Every document's identity, in canonical corpus order. */
export function listLegalDocuments(): LegalDocumentSummary[] {
  return LEGAL_SLUGS.map((slug) => ({
    slug,
    locale: LEGAL_LOCALE,
    title: LEGAL_DOCUMENT_TITLES[slug],
    lastUpdated: LEGAL_CORPUS[slug].lastUpdated,
  }));
}
