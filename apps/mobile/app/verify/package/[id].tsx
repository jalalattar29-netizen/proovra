/**
 * A verification PACKAGE link. The package page is a web surface with no native
 * counterpart, and this path is claimed by the app, so it opens in an in-app
 * browser: handing the same URL to the system could bring it straight back here.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";

import { verificationPackageUrl } from "../../../src/deep-link";
import { webOrigin } from "../../../src/product/intake-create";
import { ProovraButton, ProovraCard, ProovraScreen, ProovraText } from "../../../src/ui";

/**
 * F-P1-16 — what this app can and cannot do with a package ZIP you hold.
 * The web package page hashes a chosen ZIP in the browser (never uploaded)
 * and compares it with the digest PROOVRA recorded; the app does not.
 */
const PACKAGE_LOCAL_CHECK_COPY =
  "To check a package ZIP you hold, choose it on the package page in the browser: it is hashed there, never uploaded, and compared with the digest PROOVRA recorded. This app does not compare files on your device.";

export default function VerifyPackageLinkRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const url = useMemo(
    () => verificationPackageUrl(webOrigin(), typeof params.id === "string" ? params.id : ""),
    [params.id],
  );
  const open = useCallback(() => {
    if (url) void WebBrowser.openBrowserAsync(url);
  }, [url]);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    open();
  }, [open]);

  return (
    <ProovraScreen width="form" testID="verify-package-link">
      <ProovraCard>
        <ProovraText variant="h2" weight="semibold" accessibilityRole="header">Verification package</ProovraText>
        <ProovraText variant="body">
          {url
            ? "Verification packages open in a browser."
            : "This is a verification package link. Open it in a web browser to review the package."}
        </ProovraText>
        {/* F-P1-16 — the accurate capability state: this app has no local-file
            comparison; the web package page does it, in the browser. */}
        <ProovraText variant="bodySm" testID="verify-package-local-check">
          {PACKAGE_LOCAL_CHECK_COPY}
        </ProovraText>
        {url ? <ProovraButton label="Open the package" onPress={open} /> : null}
        <ProovraButton label="Verify a record" variant="ghost" onPress={() => router.replace("/verify")} />
      </ProovraCard>
    </ProovraScreen>
  );
}