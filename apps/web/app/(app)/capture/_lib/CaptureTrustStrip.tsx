"use client";

/**
 * Capture — the trust/protection strip.
 *
 * Three compact statements about what the platform does with material once it
 * is staged. This is EXPLANATORY PRODUCT COPY and nothing else: it reads no
 * session state, computes no verdict, and is not an integrity authority. The
 * deterministic pipeline reports itself in Integrity Preparation on the rail;
 * this strip only tells a first-time operator what is about to happen.
 *
 * WHAT IT MAY NEVER SAY
 * ---------------------------------------------------------------------------
 * No admissibility, authenticity or truth claim — "Court-ready", "Legally
 * admissible", "Court approved", "Authenticity proven", "Truth verified". The
 * platform records and verifies preservation state; it does not adjudicate.
 * `capture-workflow-hierarchy.test.ts` fails if any of those appear here.
 */

import { Fingerprint, Lock, ScrollText } from "lucide-react";

const TRUST_ITEMS = [
  {
    id: "integrity",
    Icon: Fingerprint,
    title: "Integrity by design",
    detail: "Hash, map, and verify automatically",
  },
  {
    id: "protected",
    Icon: Lock,
    title: "End-to-end protected",
    detail: "Encrypted storage and verifiable audit trail",
  },
  {
    id: "audit",
    Icon: ScrollText,
    title: "Verifiable audit trail",
    detail: "Recorded evidence operations and preservation history",
  },
] as const;

export function CaptureTrustStrip() {
  return (
    <ul className="capture-trust-strip" data-capture-trust-strip>
      {TRUST_ITEMS.map(({ id, Icon, title, detail }) => (
        <li key={id} className="capture-trust-item" data-capture-trust-item={id}>
          <span className="capture-trust-item__icon" aria-hidden="true">
            <Icon size={16} strokeWidth={2} />
          </span>
          <span className="capture-trust-item__copy">
            <strong>{title}</strong>
            <small>{detail}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default CaptureTrustStrip;
