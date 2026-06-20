"use client";

// CR0 Phase: the legacy `/security/trust-center` path is now a thin
// client-side redirect to the canonical `/trust` hub. It is wrapped in
// `PageRouteGate` so the CR0 system-freeze guarantee (every (app) page
// either uses PageRouteGate or sits on the documented exemption list)
// holds without weakening the test. The gate sees the standard
// entitlement context; the inner shim performs the redirect once
// rendering reaches it.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

function RedirectShim() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/trust");
  }, [router]);
  return null;
}

export default function LegacySecurityTrustCenterRedirect() {
  return (
    <PageRouteGate routeId="trust.center">
      <RedirectShim />
    </PageRouteGate>
  );
}
