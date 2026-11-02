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
        {url ? <ProovraButton label="Open the package" onPress={open} /> : null}
        <ProovraButton label="Verify a record" variant="ghost" onPress={() => router.replace("/verify")} />
      </ProovraCard>
    </ProovraScreen>
  );
}