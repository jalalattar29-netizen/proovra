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

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/**
 * THE policies a user must accept, and THE version they must accept.
 *
 * ===========================================================================
 * WHY THIS IS DERIVED AND NOT WRITTEN DOWN
 * ===========================================================================
 * The required version used to be a hand-maintained table of three date
 * strings, and it existed in FOUR places: the API's `legal-versioning.ts` and
 * a local `const REQUIRED_LEGAL_VERSIONS` in each of the register, login and
 * verify-email pages. All four said `2026-04-06`. The documents themselves had
 * moved to `2026-06-23` and `2026-06-26` months earlier.
 *
 * So every user was accepting a version of the Terms that no longer matched
 * the Terms they were shown, and the acceptance record said they had agreed to
 * a document revision that was not the one on screen. That is the one thing an
 * acceptance record exists to state correctly.
 *
 * A table that has to be edited when a document changes will go stale again.
 * This is computed from the corpus instead: the document's own `Last Updated:`
 * line IS the version a user accepts, because that is how the product has
 * always expressed it — `policyVersion` is a `VarChar(32)` holding exactly
 * that date string.
 *
 * WHAT IS SEPARATE, AND WHAT IS NOT
 * ===========================================================================
 * The document's REVISION (its `Last Updated:` line) and the ACCEPTANCE
 * REQUIREMENT are two different questions — "which revision is published?"
 * and "which revision must a user have accepted?" — and they now have two
 * names, because a surface that reads one while meaning the other cannot be
 * caught while they happen to be equal.
 *
 * They ARE equal by default, and that default is the derivation above. The
 * only way to separate them is `ACCEPTANCE_PINS`, which can hold a policy at
 * an EARLIER published revision: the case the collapse cannot express, where
 * correcting a typo should not ask every user in the product to re-accept.
 *
 * A pin LATER than the published document is refused at module load. That is
 * the direction the old hand-maintained table failed in, and it is the only
 * direction that can put a revision a user never saw into an acceptance
 * record.
 */
export const REQUIRED_LEGAL_POLICY_KEYS = ["terms", "privacy", "cookies"] as const;

export type RequiredLegalPolicyKey = (typeof REQUIRED_LEGAL_POLICY_KEYS)[number];

export type RequiredLegalVersions = Record<RequiredLegalPolicyKey, string>;

/**
 * The version of each acceptance-gated policy, as its document states it.
 *
 * Computed once at module load. The corpus is immutable for the lifetime of a
 * build, so there is nothing to recompute and no way for a caller to observe a
 * different answer than its neighbour.
 */
/**
 * The PUBLISHED revision of each acceptance-gated policy.
 *
 * What the document itself says. Named separately from the requirement below
 * so a caller states which one it means.
 */
export const LEGAL_DOCUMENT_REVISIONS: RequiredLegalVersions = Object.freeze(
  Object.fromEntries(
    REQUIRED_LEGAL_POLICY_KEYS.map((key) => [key, LEGAL_CORPUS[key].lastUpdated]),
  ) as RequiredLegalVersions,
);

/**
 * Policies deliberately held at an EARLIER published revision.
 *
 * Empty, and expected to stay empty most of the time: the requirement equals
 * the published revision unless somebody decides a change does not warrant
 * asking every user to accept it again. That decision belongs to whoever
 * publishes the change, which is why it is written here rather than inferred.
 *
 * A pin must name a date the corpus has actually published, and must not be
 * later than the current one. `assertAcceptancePinsAreSane` refuses both at
 * module load rather than at the moment a user is asked to accept something.
 */
export const ACCEPTANCE_PINS: Readonly<Partial<RequiredLegalVersions>> = Object.freeze({});

function assertAcceptancePinsAreSane(): void {
  for (const key of REQUIRED_LEGAL_POLICY_KEYS) {
    const pinned = ACCEPTANCE_PINS[key];
    if (pinned === undefined) continue;
    const published = LEGAL_DOCUMENT_REVISIONS[key];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pinned)) {
      throw new Error(`ACCEPTANCE_PINS.${key} is "${pinned}", which is not a revision date.`);
    }
    if (pinned > published) {
      throw new Error(
        `ACCEPTANCE_PINS.${key} is ${pinned}, later than the published ${published}. ` +
          "An acceptance record would then name a revision the user was never shown.",
      );
    }
  }
}

assertAcceptancePinsAreSane();

/**
 * The version of each acceptance-gated policy a user must have accepted.
 *
 * The published revision, unless that policy is deliberately pinned to an
 * earlier one. Equal to `LEGAL_DOCUMENT_REVISIONS` while nothing is pinned.
 */
export const REQUIRED_LEGAL_VERSIONS: RequiredLegalVersions = Object.freeze(
  Object.fromEntries(
    REQUIRED_LEGAL_POLICY_KEYS.map((key) => [
      key,
      ACCEPTANCE_PINS[key] ?? LEGAL_DOCUMENT_REVISIONS[key],
    ]),
  ) as RequiredLegalVersions,
);

/** The revision the document publishes, whatever the requirement is. */
export function legalDocumentRevision(key: RequiredLegalPolicyKey): string {
  return LEGAL_DOCUMENT_REVISIONS[key];
}

/**
 * True when a user is being asked to accept something older than what they
 * are shown — which is legitimate, and which a surface displaying both dates
 * should be able to say out loud rather than leaving the reader to notice.
 */
export function acceptanceIsPinnedBehind(key: RequiredLegalPolicyKey): boolean {
  return REQUIRED_LEGAL_VERSIONS[key] !== LEGAL_DOCUMENT_REVISIONS[key];
}

export function getRequiredLegalVersions(): RequiredLegalVersions {
  return REQUIRED_LEGAL_VERSIONS;
}

/**
 * The ACCEPTANCE REQUIREMENT for one slug, or null when it is not gated.
 *
 * Not the published revision — `legalDocumentRevision` is that. The two are
 * equal unless the policy is pinned.
 */
export function requiredAcceptanceFor(
  slug: string,
): { policyKey: RequiredLegalPolicyKey; requiredVersion: string } | null {
  if (!(REQUIRED_LEGAL_POLICY_KEYS as readonly string[]).includes(slug)) return null;
  const key = slug as RequiredLegalPolicyKey;
  return { policyKey: key, requiredVersion: REQUIRED_LEGAL_VERSIONS[key] };
}
