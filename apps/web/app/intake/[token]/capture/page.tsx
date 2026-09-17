"use client";

/**
 * /intake/[token]/capture — RETIRED citizen capture page (UC-0).
 *
 * This page used to pick a file from disk, sign it with an in-memory browser
 * key, post it as base64 JSON, and describe the result as "Class B (browser
 * captured)". A file chosen from disk is an upload, not a capture, and the
 * API it called anchored on the intake link's id rather than its secret token
 * and skipped the intake session's consent and identity steps. That API now
 * answers 410.
 *
 * Contributors submit through the canonical secure intake flow at
 * /intake/[token], which records the submission as "Submitted through a
 * secure intake link", uploads the bytes to storage, and enforces consent.
 * This page only hands off to it; it creates nothing and signs nothing.
 */

import Link from "next/link";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RetiredCitizenCapturePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const target = `/intake/${encodeURIComponent(token)}`;

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return (
    <main
      data-citizen-capture-retired
      style={{ maxWidth: 640, margin: "0 auto", padding: "28px 20px", lineHeight: 1.55 }}
    >
      <h1 style={{ fontSize: 22, margin: 0 }}>Submit files securely</h1>
      <p style={{ margin: "8px 0 0" }}>
        Submissions now go through the secure intake page.{" "}
        <Link href={target}>Continue to the secure intake page</Link>.
      </p>
    </main>
  );
}
