/**
 * A verification link opened from outside: https://www.proovra.com/verify/<ref>,
 * or proovra://verify/<ref>. The app claims this path, and the Share button on the
 * verification screen builds exactly this URL, so it must land on the screen that
 * verifies rather than on the router's unmatched page (MOBILE-004).
 */
import { Redirect, useLocalSearchParams } from "expo-router";

import { extractVerificationId } from "../../src/deep-link";

export default function VerifyLinkRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = extractVerificationId(typeof params.id === "string" ? params.id : "");
  return <Redirect href={id ? { pathname: "/verify", params: { id } } : "/verify"} />;
}